#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <liburing.h>

#define QUEUE_DEPTH 4
#define BUFFER_SIZE 1024

int main() {
    struct io_uring ring;
    int ret;

    // 1. Initialize Submission Queue (SQ) and Completion Queue (CQ) ring buffers
    ret = io_uring_queue_init(QUEUE_DEPTH, &ring, 0);
    if (ret < 0) {
        fprintf(stderr, "Failed to initialize io_uring: %s\n", strerror(-ret));
        return 1;
    }
    printf("[io_uring] Ring created successfully! Ring FD: %d\n", ring.ring_fd);

    // 2. Open the target file descriptor
    int fd = open("sample.txt", O_RDONLY);
    if (fd < 0) {
        perror("Failed to open sample.txt");
        io_uring_queue_exit(&ring);
        return 1;
    }

    // 3. Acquire a vacant Submission Queue Entry (SQE)
    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    if (!sqe) {
        fprintf(stderr, "No SQE available!\n");
        close(fd);
        io_uring_queue_exit(&ring);
        return 1;
    }

    char buffer[BUFFER_SIZE] = {0};

    // 4. Prepare the read operation in user-space shared memory
    io_uring_prep_read(sqe, fd, buffer, BUFFER_SIZE - 1, 0);

    // Attach arbitrary correlation metadata (e.g., pointer or request ID) to user_data
    io_uring_sqe_set_data64(sqe, 42);

    printf("[io_uring] Read request staged in submission queue.\n");

    // 5. Notify the kernel of pending requests (invokes io_uring_enter syscall)
    ret = io_uring_submit(&ring);
    if (ret < 0) {
        fprintf(stderr, "Failed to submit to io_uring: %s\n", strerror(-ret));
        close(fd);
        io_uring_queue_exit(&ring);
        return 1;
    }
    printf("[io_uring] %d request(s) submitted to the kernel!\n", ret);

    // 6. Wait for the completion event to arrive in the CQ (Completion Queue)
    struct io_uring_cqe *cqe;
    ret = io_uring_wait_cqe(&ring, &cqe);
    if (ret < 0) {
        fprintf(stderr, "Failed waiting for CQE: %s\n", strerror(-ret));
        close(fd);
        io_uring_queue_exit(&ring);
        return 1;
    }

    printf("[io_uring] Completion event received! user_data = %llu, bytes read = %d\n",
           (unsigned long long)cqe->user_data, cqe->res);

    if (cqe->res < 0) {
        fprintf(stderr, "File read error: %s\n", strerror(-cqe->res));
    } else {
        printf("\n--- Content read via io_uring ---\n%s\n---------------------------------\n", buffer);
    }

    // 7. Mark the CQE as seen and clean up resources
    io_uring_cqe_seen(&ring, cqe);
    close(fd);
    io_uring_queue_exit(&ring);

    printf("[io_uring] Finished successfully!\n");
    return 0;
}
